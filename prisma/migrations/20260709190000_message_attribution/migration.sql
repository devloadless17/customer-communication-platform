-- Ad / deep-link attribution (Click-to-WhatsApp / Click-to-Messenger) on the
-- first inbound of an ad-sourced conversation. Shape = MessageAttribution.
ALTER TABLE "Message" ADD COLUMN "attribution" JSONB;
