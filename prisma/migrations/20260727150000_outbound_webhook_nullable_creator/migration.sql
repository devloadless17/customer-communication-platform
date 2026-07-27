-- /v1 parity build: an integration can now register its own outbound webhook,
-- and an API key is not a person — so the creator becomes optional rather than
-- forcing us to invent a human author for an action no human took.
--
-- DROP NOT NULL only: the column, its data and every index on it are untouched
-- (see the hand-maintained partial-index section in 0_init — a DROP COLUMN
-- here would silently destroy them).
ALTER TABLE "OutboundWebhook" ALTER COLUMN "createdById" DROP NOT NULL;
