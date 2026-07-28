-- Policy/spam MESSAGING enforcement state (the policy-enforcement guide's
-- escalation ladder: 1/3-day blocks on business-initiated template sends,
-- 5/7/30-day blocks on ALL messages, indefinite lock/disable). One
-- (type, until) pair per blocked direction, WABA-scoped; type is the presence
-- marker because an indefinite lock carries no expiry. First-class rather
-- than a lastAccountAlert entry because the broadcast composer must warn
-- BEFORE an operator fires a campaign into a restricted account, and the
-- health panel needs the lift date.
--
-- Additive nullable columns only — no index, no raw-index section impact.
ALTER TABLE "ChannelConnection"
  ADD COLUMN "bizMessagingRestrictionType" TEXT,
  ADD COLUMN "bizMessagingRestrictedUntil" TIMESTAMP(3),
  ADD COLUMN "customerMessagingRestrictionType" TEXT,
  ADD COLUMN "customerMessagingRestrictedUntil" TIMESTAMP(3);
