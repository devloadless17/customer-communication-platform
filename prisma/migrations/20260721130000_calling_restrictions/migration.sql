-- Mirror the provider's calling enforcement onto the channel connection.
--
-- Meta pauses calling on a number (typically ~7 days) over negative user
-- feedback or a low call-pickup rate, and warns before it does. While paused,
-- every call attempt and every call-permission request fails. Previously we
-- ingested neither signal, so a restricted tenant saw only a week of
-- unexplained errors with nothing in the product to explain them.
ALTER TABLE "ChannelConnection"
  ADD COLUMN "callingRestrictedUntil"   TIMESTAMP(3),
  ADD COLUMN "callingRestrictionType"   TEXT,
  ADD COLUMN "callingRestrictionReason" TEXT,
  ADD COLUMN "callingQualityWarning"    TEXT;
