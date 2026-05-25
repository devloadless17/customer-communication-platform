-- Scope phone uniqueness to channels where phone IS the identity.
--
-- Before: `Contact_teamId_phoneNumber_key` was a FULL unique on (teamId,
-- phoneNumber). That blocked future multi-channel cases where Instagram /
-- Telegram contacts could legitimately share a phone (different accounts,
-- same human or coincidental overlap) — their identity is
-- (identityChannel, externalContactId), not phone.
--
-- After: a PARTIAL unique that only fires for WhatsApp (the channel where
-- phone IS the natural key). Non-WhatsApp contacts can store phone freely
-- without colliding. Re-contact resurrection still works because the
-- partial index covers active + soft-deleted rows for WhatsApp identically.
--
-- The schema-side `@@index([teamId, phoneNumber])` provides the regular
-- lookup index for cross-channel phone searches. The partial unique is
-- raw SQL (Prisma can't model partial indexes) — same drift-stripping
-- pattern as `Contact_customFields_gin_idx`.

DROP INDEX "Contact_teamId_phoneNumber_key";

CREATE INDEX "Contact_teamId_phoneNumber_idx" ON "Contact" ("teamId", "phoneNumber");

CREATE UNIQUE INDEX "Contact_teamId_phoneNumber_whatsapp_key"
  ON "Contact" ("teamId", "phoneNumber")
  WHERE "phoneNumber" IS NOT NULL
    AND ("identityChannel" IS NULL OR "identityChannel" = 'whatsapp');
