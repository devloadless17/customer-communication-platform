-- Add the Meta social channels to the Channel enum.
--
-- These are additive enum values only — no existing row changes. `whatsapp`
-- stays phone-based; `messenger`/`instagram` are Meta social channels keyed by
-- an opaque page-scoped id (PSID / IGSID) stored in Contact.externalContactId
-- (the `@@unique([teamId, identityChannel, externalContactId])` path), not a
-- phone number. The partial WhatsApp-only phone unique index is unaffected.
--
-- Postgres requires each ALTER TYPE ... ADD VALUE to be its own statement and
-- forbids using the new value in the same transaction it is added — this
-- migration only declares the values, so it is safe.

ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'messenger';
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'instagram';
