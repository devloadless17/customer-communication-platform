-- Local organizational labels on a WhatsApp template ("promo", "ramadan-2026",
-- "support") — the operator's own taxonomy for filtering/searching the catalog.
-- OURS, like `variableBindings`: Meta has no such concept, nothing goes over the
-- Graph wire, and the catalog sync's reconcile writes explicit fields only, so a
-- re-sync leaves labels untouched. Additive + defaulted, so every existing row is
-- simply unlabeled.
ALTER TABLE "MessageTemplate" ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT '{}';
