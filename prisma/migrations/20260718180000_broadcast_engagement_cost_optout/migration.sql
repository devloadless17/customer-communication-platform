-- Campaign reporting phases 2-4: engagement (replies + button clicks), cost,
-- and marketing opt-out / suppression.
--
-- All additive and nullable/defaulted → metadata-only on PG16, no table rewrite
-- even on Message and Contact. Plain CREATE INDEX (not CONCURRENTLY): Prisma
-- applies each migration inside a transaction, so CONCURRENTLY cannot run —
-- same deliberate tradeoff documented in 20260718110949 and 20260718170000.

-- ── Phase 2: engagement ─────────────────────────────────────────────────────
-- Persist the structured button/list tap that meta.ts has always parsed and
-- then thrown away (only the button's display TITLE reached the DB, via body).
-- Reporting keys on the stable id, never the editable title.
ALTER TABLE "Message"
  ADD COLUMN "interactiveOptionId"   TEXT,
  ADD COLUMN "interactiveOptionKind" TEXT;

ALTER TABLE "BroadcastRecipient"
  ADD COLUMN "repliedAt"          TIMESTAMP(3),
  ADD COLUMN "repliedMessageId"   TEXT,
  ADD COLUMN "repliedAttribution" TEXT,
  ADD COLUMN "clickedAt"          TIMESTAMP(3),
  ADD COLUMN "clickedOptionId"    TEXT,
  ADD COLUMN "optedOutAt"         TIMESTAMP(3),
-- ── Phase 3: cost (category + billable only; Meta sends no price) ───────────
  ADD COLUMN "pricingCategory"    TEXT,
  ADD COLUMN "pricingBillable"    BOOLEAN,
  ADD COLUMN "pricingModel"       TEXT;

-- Reply attribution probes "most recent campaign this contact was sent, inside
-- the window" on every inbound message. contactId-leading, so it also still
-- backs the Contact-cascade delete that the bare (contactId) index served —
-- which is now a redundant leftmost prefix and is dropped in the same step so
-- the table's index count stays flat.
CREATE INDEX "BroadcastRecipient_contactId_sentAt_idx"
  ON "BroadcastRecipient"("contactId", "sentAt" DESC);
DROP INDEX IF EXISTS "BroadcastRecipient_contactId_idx";

-- ── Phase 4: marketing opt-out + suppression ────────────────────────────────
ALTER TABLE "Contact"
  ADD COLUMN "marketingOptOutAt"     TIMESTAMP(3),
  ADD COLUMN "marketingOptOutSource" TEXT;

ALTER TABLE "Broadcast"
  ADD COLUMN "suppressedCount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "templateCategory" TEXT;

-- Partial: the overwhelming majority of contacts never opt out, so a full index
-- would be mostly-dead weight on a large contact book. Serves the audience
-- suppression filter and the "opt-outs this period" report.
CREATE INDEX "Contact_teamId_marketingOptOutAt_idx"
  ON "Contact"("teamId", "marketingOptOutAt") WHERE "marketingOptOutAt" IS NOT NULL;
