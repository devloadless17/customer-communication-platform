-- Multi-channel + collaboration polish. Bundles six concerns:
--
--   1) ConversationEventKind enum + ConversationEvent table — audit timeline
--      for assign / status / tag changes. The right-rail history panel reads
--      it; today's writes happen in the assign/status/tags routes.
--   2) ConversationReadReceipt — per-(user, conversation) read state. The
--      sidebar badge filters on these; Conversation.unreadCount stays as a
--      cheap "anything unread for the team" hint.
--   3) Conversation tags (move from Contact to Conversation). Migrates rows
--      in `_ContactToTag` onto every conversation the contact owns, then
--      drops the old join table. Preserves the previous "all of a contact's
--      tags apply to all their threads" semantic — agents can prune
--      per-conversation from the inbox UI.
--   4) Message externalId compound unique. Bare `@unique` would collide
--      across providers (Meta wamid vs future Instagram/Telegram ids);
--      compound on (teamId, provider, externalId) gives each channel its
--      own id space and keeps dedupe correct.
--   5) Contact identity for non-phone channels. phoneNumber goes nullable,
--      identityProvider + externalContactId added. WhatsApp contacts still
--      use phoneNumber; Instagram/Telegram contacts will set the identity
--      pair instead. The compound unique enforces dedupe in either mode
--      (Postgres treats multiple NULLs as distinct so both modes coexist).
--   6) Two new back-relation surfaces are picked up automatically by the
--      generated client — no DB change beyond the new tables/columns above.
--
-- Idempotency notes: every CREATE in this file is gated by IF NOT EXISTS
-- where Postgres allows it, so a half-applied run can be re-run safely on
-- a dev DB. Production deploys go through `prisma migrate deploy` which
-- tracks the row in `_prisma_migrations` and won't re-run a completed file.

-- ---------------------------------------------------------------------------
-- 1) ConversationEvent audit log
-- ---------------------------------------------------------------------------

CREATE TYPE "ConversationEventKind" AS ENUM (
  'assigned', 'status_changed', 'tag_added', 'tag_removed'
);

CREATE TABLE "ConversationEvent" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "teamId"         TEXT NOT NULL,
  "userId"         TEXT,
  "kind"           "ConversationEventKind" NOT NULL,
  "before"         JSONB,
  "after"          JSONB,
  "at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ConversationEvent_conversationId_at_idx"
  ON "ConversationEvent" ("conversationId", "at" DESC);
CREATE INDEX "ConversationEvent_teamId_at_idx"
  ON "ConversationEvent" ("teamId", "at" DESC);

ALTER TABLE "ConversationEvent"
  ADD CONSTRAINT "ConversationEvent_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationEvent"
  ADD CONSTRAINT "ConversationEvent_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationEvent"
  ADD CONSTRAINT "ConversationEvent_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2) ConversationReadReceipt per-agent unread
-- ---------------------------------------------------------------------------

CREATE TABLE "ConversationReadReceipt" (
  "id"             TEXT NOT NULL,
  "userId"         TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "lastReadAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConversationReadReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationReadReceipt_userId_conversationId_key"
  ON "ConversationReadReceipt" ("userId", "conversationId");
CREATE INDEX "ConversationReadReceipt_conversationId_idx"
  ON "ConversationReadReceipt" ("conversationId");

ALTER TABLE "ConversationReadReceipt"
  ADD CONSTRAINT "ConversationReadReceipt_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversationReadReceipt"
  ADD CONSTRAINT "ConversationReadReceipt_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 3) Conversation tags (move from Contact, preserve data)
-- ---------------------------------------------------------------------------

CREATE TABLE "_ConversationTags" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_ConversationTags_AB_pkey" PRIMARY KEY ("A","B")
);
CREATE INDEX "_ConversationTags_B_index" ON "_ConversationTags"("B");

ALTER TABLE "_ConversationTags"
  ADD CONSTRAINT "_ConversationTags_A_fkey"
  FOREIGN KEY ("A") REFERENCES "Conversation"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_ConversationTags"
  ADD CONSTRAINT "_ConversationTags_B_fkey"
  FOREIGN KEY ("B") REFERENCES "Tag"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy: for each (contact, tag) pair, attach the tag to every conversation
-- that contact owns. DISTINCT collapses duplicates created by multi-tag
-- contacts with multiple conversations. ON CONFLICT DO NOTHING in case
-- the migration is re-run on a partially-populated dev DB.
INSERT INTO "_ConversationTags" ("A", "B")
SELECT DISTINCT co."id", ct."B"
FROM "_ContactToTag" ct
JOIN "Conversation" co ON co."contactId" = ct."A"
ON CONFLICT DO NOTHING;

-- Drop the old contact-tag join. Old `Contact.tags` queries die from here on
-- — every caller must move to `conversation.tags` (or the derived "all tags
-- across a contact's conversations" view in lib/queries/contacts.ts).
DROP TABLE "_ContactToTag";

-- ---------------------------------------------------------------------------
-- 4) Message externalId compound unique
-- ---------------------------------------------------------------------------

-- Drop the bare-column unique that the schema's `@unique` produced.
DROP INDEX "Message_externalId_key";

-- Compound covers the same dedupe ground plus the multi-provider future.
-- Existing rows are all provider='meta_cloud' so the new constraint accepts
-- them without conflicts; any row that was unique on externalId alone is
-- also unique on (teamId, provider, externalId).
CREATE UNIQUE INDEX "Message_teamId_provider_externalId_key"
  ON "Message" ("teamId", "provider", "externalId");

-- ---------------------------------------------------------------------------
-- 5) Contact identity for non-phone channels
-- ---------------------------------------------------------------------------

-- phoneNumber goes nullable. Existing WhatsApp rows stay populated; only
-- Instagram/Telegram ingest (later) will write rows with NULL phone.
ALTER TABLE "Contact" ALTER COLUMN "phoneNumber" DROP NOT NULL;

-- Identity pair for non-phone channels. ProviderName enum already exists.
ALTER TABLE "Contact" ADD COLUMN "identityProvider" "ProviderName";
ALTER TABLE "Contact" ADD COLUMN "externalContactId" TEXT;

-- Compound unique: enforced only when both fields are set (Postgres treats
-- NULL as distinct, so multiple WhatsApp contacts with NULL/NULL coexist
-- harmlessly).
CREATE UNIQUE INDEX "Contact_teamId_identityProvider_externalContactId_key"
  ON "Contact" ("teamId", "identityProvider", "externalContactId");
