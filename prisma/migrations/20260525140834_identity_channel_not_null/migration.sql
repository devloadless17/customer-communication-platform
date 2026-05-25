-- Tighten Contact.identityChannel to NOT NULL.
--
-- Safe to run because the prior migration 20260525135307 backfilled every
-- existing NULL row to 'whatsapp', and every contact-create path in the
-- codebase now stamps identityChannel explicitly (ingest, manual create,
-- CSV import, /v1, workflow target, seed scripts).
--
-- Validation pass on SET NOT NULL is fast (no NULLs to find). Done now
-- while the table is small enough that a future tightening — if we waited
-- — would have been a real "big migration" at customer-scale.

ALTER TABLE "Contact" ALTER COLUMN "identityChannel" SET NOT NULL;

-- Simplify the partial phone-unique WHERE clause. Before this migration
-- the predicate was `phoneNumber IS NOT NULL AND (identityChannel IS NULL
-- OR identityChannel = 'whatsapp')` — the OR-NULL clause covered legacy
-- WhatsApp rows that pre-dated the explicit channel stamp. Now that the
-- column is NOT NULL, no row can match `IS NULL`, so the clause is dead
-- code. Drop + recreate with the cleaner predicate.

DROP INDEX "Contact_teamId_phoneNumber_whatsapp_key";

CREATE UNIQUE INDEX "Contact_teamId_phoneNumber_whatsapp_key"
  ON "Contact" ("teamId", "phoneNumber")
  WHERE "phoneNumber" IS NOT NULL
    AND "identityChannel" = 'whatsapp';
