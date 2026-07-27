-- WhatsApp number identity: the Meta-verified display name + its review
-- status. The connect flow fetched `verified_name` and discarded it, and the
-- `phone_number_name_update` webhook was ignored entirely — so a DECLINED or
-- EXPIRED display name (which also voids the number's certificate, blocking
-- Cloud API registration) was invisible until sends failed.
--
-- Additive nullable columns only — no index, no raw-index section impact.
ALTER TABLE "ChannelConnection"
  ADD COLUMN "verifiedName" TEXT,
  ADD COLUMN "nameStatus" TEXT;
