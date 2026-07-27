-- Template-categorization enforcement state (Meta's utility-template-abuse
-- escalation ladder): the raw restriction_type + Meta's expiry, WABA-scoped.
-- First-class rather than a lastAccountAlert entry because the broadcast
-- composer must warn BEFORE an operator fires a utility campaign into a
-- rate-limited WABA — messages over the cap are rejected by Meta.
--
-- Additive nullable columns only — no index, no raw-index section impact.
ALTER TABLE "ChannelConnection"
  ADD COLUMN "utilityRestrictionType" TEXT,
  ADD COLUMN "utilityRestrictedUntil" TIMESTAMP(3);
