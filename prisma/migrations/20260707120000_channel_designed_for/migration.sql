-- Add the DESIGNED-FOR (not-yet-implemented) channels to the Channel enum.
--
-- telegram / email / sms have capability + identity maps in @ccp/shared so the
-- architecture is ready, but there is NO MessagingProvider / webhook / onboarding
-- for them yet (they're absent from @ccp/shared LIVE_CHANNELS and the provider
-- REGISTRY). No row can carry these channels until a focused session ships the
-- implementation — so this is a pure, additive enum extension with zero data
-- impact.
--
-- Postgres forbids using a new enum value in the same transaction it's added;
-- this migration only declares the values.

ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'telegram';
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'email';
ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'sms';
