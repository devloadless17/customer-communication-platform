-- Multi-account channels.
--
-- A workspace can now hold SEVERAL accounts of one channel (two WhatsApp
-- numbers, two Pages, two IG handles) instead of exactly one. This generalises
-- the pattern `webchatwidget` already used (its own per-account table + a
-- per-conversation pointer + resolve-by-key inbound).
--
-- DATA-PRESERVING by design: the generated diff wanted to DROP
-- ChannelConnection.messagingTier/messagingDailyCap outright, which would have
-- thrown away each number's messaging-limit snapshot. The backfills below move
-- that data onto WhatsappPortfolio FIRST, then drop the columns.

-- 1. Portfolio table (created first — the backfill below writes into it).
CREATE TABLE "WhatsappPortfolio" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "externalPortfolioId" TEXT,
    "messagingTier" TEXT,
    "messagingDailyCap" INTEGER,
    "messagingHealthUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsappPortfolio_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WhatsappPortfolio_workspaceId_idx" ON "WhatsappPortfolio"("workspaceId");
CREATE UNIQUE INDEX "WhatsappPortfolio_workspaceId_externalPortfolioId_key" ON "WhatsappPortfolio"("workspaceId", "externalPortfolioId");

-- 2. New per-account columns (additive; nothing dropped yet).
ALTER TABLE "ChannelConnection"
  ADD COLUMN "externalAccountId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "label" TEXT,
  ADD COLUMN "portfolioId" TEXT,
  ADD COLUMN "wabaId" TEXT;

-- 3. Backfill the account identity out of `config` JSON. Each channel keeps its
--    own provider id: WhatsApp phone-number id, Messenger page id, IG ig id.
--    webchatwidget has no ChannelConnection row (it uses WebchatWidget).
--    NOTE: the id is picked PER CHANNEL, not by a COALESCE fallback. An
--    Instagram config carries BOTH `pageId` (the linked Facebook Page) and
--    `igId`, and IG webhooks arrive keyed by the IG id — a COALESCE that tried
--    pageId first would store the Page id and the account would never match an
--    inbound payload.
UPDATE "ChannelConnection"
SET "externalAccountId" = CASE "channel"
      WHEN 'whatsapp'  THEN COALESCE("config" ->> 'phoneNumberId', '')
      WHEN 'messenger' THEN COALESCE("config" ->> 'pageId', '')
      WHEN 'instagram' THEN COALESCE("config" ->> 'igId', '')
      ELSE ''
    END,
    "wabaId" = "config" ->> 'wabaId';

-- 4. Every pre-existing connection was its channel's ONLY account, so it is the
--    default one to send from.
UPDATE "ChannelConnection" SET "isDefault" = true;

-- 5. Move each WhatsApp number's messaging-limit snapshot onto a portfolio.
--    Pre-migration we never read Meta's portfolio id, so we mint one portfolio
--    per (workspace, wabaId) — correct for today's one-WABA-per-workspace
--    reality, and the health sweeper fills in `externalPortfolioId` on its next
--    pass. The cap is carried over so the pre-send gate keeps working with no
--    gap (a NULL cap would silently mean "ungated").
INSERT INTO "WhatsappPortfolio" ("id", "workspaceId", "messagingTier", "messagingDailyCap", "messagingHealthUpdatedAt", "createdAt", "updatedAt")
SELECT DISTINCT ON ("workspaceId", COALESCE("wabaId", ''))
       gen_random_uuid()::text,
       "workspaceId",
       "messagingTier",
       "messagingDailyCap",
       "messagingHealthUpdatedAt",
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "ChannelConnection"
WHERE "channel" = 'whatsapp';

UPDATE "ChannelConnection" c
SET "portfolioId" = p."id"
FROM "WhatsappPortfolio" p
WHERE c."channel" = 'whatsapp' AND p."workspaceId" = c."workspaceId";

-- 6. Snapshot moved — now the per-number columns can go.
ALTER TABLE "ChannelConnection"
  DROP COLUMN "messagingDailyCap",
  DROP COLUMN "messagingTier";

-- 7. One row per ACCOUNT rather than per channel.
DROP INDEX "ChannelConnection_workspaceId_channel_key";
CREATE UNIQUE INDEX "ChannelConnection_workspaceId_channel_externalAccountId_key" ON "ChannelConnection"("workspaceId", "channel", "externalAccountId");
CREATE INDEX "ChannelConnection_workspaceId_channel_idx" ON "ChannelConnection"("workspaceId", "channel");
CREATE INDEX "ChannelConnection_channel_externalAccountId_idx" ON "ChannelConnection"("channel", "externalAccountId");
CREATE INDEX "ChannelConnection_portfolioId_idx" ON "ChannelConnection"("portfolioId");

-- 8. Per-thread + per-campaign account binding.
ALTER TABLE "Conversation" ADD COLUMN "channelConnectionId" TEXT;
ALTER TABLE "Broadcast" ADD COLUMN "channelConnectionId" TEXT;

-- 9. Bind existing threads to their channel's (only) account, so outbound keeps
--    resolving after the cutover instead of hitting `send_account_unresolved`.
UPDATE "Conversation" cv
SET "channelConnectionId" = c."id"
FROM "ChannelConnection" c
WHERE c."workspaceId" = cv."workspaceId" AND c."channel" = cv."channel";

-- 10. Templates are scoped to a WABA (numbers under one WABA share a catalog).
ALTER TABLE "MessageTemplate" ADD COLUMN "wabaId" TEXT;
UPDATE "MessageTemplate" t
SET "wabaId" = c."wabaId"
FROM "ChannelConnection" c
WHERE c."workspaceId" = t."workspaceId" AND c."channel" = 'whatsapp';

DROP INDEX "MessageTemplate_workspaceId_name_language_key";
CREATE UNIQUE INDEX "MessageTemplate_workspaceId_wabaId_name_language_key" ON "MessageTemplate"("workspaceId", "wabaId", "name", "language");

-- 11. Foreign keys.
ALTER TABLE "ChannelConnection" ADD CONSTRAINT "ChannelConnection_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "WhatsappPortfolio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WhatsappPortfolio" ADD CONSTRAINT "WhatsappPortfolio_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "ChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
