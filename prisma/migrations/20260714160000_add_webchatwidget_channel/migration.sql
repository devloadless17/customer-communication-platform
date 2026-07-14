-- Add the first-party website chat-widget channel to the Channel enum.
--
-- `webchatwidget` is an embeddable in-browser chat widget (a <script> tag the
-- org drops on their site). It has capability + identity maps in @ccp/shared
-- and, unlike telegram/email/sms, ships WITH its provider + visitor transport +
-- onboarding in this change, so it is added to LIVE_CHANNELS. This migration
-- itself is a pure, additive enum extension with zero data impact.
--
-- Postgres forbids using a new enum value in the same transaction it's added;
-- this migration only declares the value.

ALTER TYPE "Channel" ADD VALUE IF NOT EXISTS 'webchatwidget';
