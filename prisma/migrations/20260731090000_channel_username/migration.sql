-- The number's WhatsApp @username (whatsapp channel only). A cache of Meta's
-- value — the settings read-through and the business_username_updates webhook
-- keep it fresh; Graph is the authority. Additive only.
ALTER TABLE "ChannelConnection" ADD COLUMN "businessUsername" TEXT;
