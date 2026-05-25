-- Backfill: every existing WhatsApp contact gets identityChannel = 'whatsapp'.
--
-- Before: WhatsApp contacts were created with identityChannel = NULL
-- because phone was their natural key (the field was reserved for non-phone
-- channels like Instagram/Telegram). That worked while WhatsApp was the
-- only channel but it makes channel filtering ugly: "show all WA contacts"
-- has to do `WHERE identityChannel = 'whatsapp' OR identityChannel IS NULL`,
-- and at customer-scale that NULL handling spreads everywhere.
--
-- After: every contact carries its channel explicitly. WhatsApp inbound
-- (lib/providers/ingest.ts), manual create (contacts.service.ts), CSV
-- import (contacts.service.ts), and external /v1 (external-v1.service.ts)
-- all now stamp `identityChannel = 'whatsapp'` on create.
--
-- Backfill rule: a row with a phoneNumber and no identityChannel is
-- WhatsApp by definition (the only channel keyed by phone today). Rows
-- with identityChannel already set are left alone — they're already
-- normalized.
--
-- The schema-level column stays nullable for now (no `ALTER ... SET NOT
-- NULL`) — the external API wire shape still types it as `Channel | null`
-- for partner backwards-compat. After the backfill there are no NULLs in
-- the table, so a future `SET NOT NULL` becomes a one-line zero-data
-- migration whenever we want to tighten the contract.
--
-- The existing partial unique `Contact_teamId_phoneNumber_whatsapp_key`
-- keeps the `OR identityChannel IS NULL` clause as defense-in-depth — if
-- some future code path forgets to stamp the channel, the constraint still
-- catches duplicate phones.

UPDATE "Contact"
SET "identityChannel" = 'whatsapp'
WHERE "identityChannel" IS NULL
  AND "phoneNumber" IS NOT NULL;
