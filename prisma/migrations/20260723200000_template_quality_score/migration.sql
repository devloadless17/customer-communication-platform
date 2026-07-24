-- Meta's per-template quality band (GREEN | YELLOW | RED | UNKNOWN).
--
-- Quality feeds template PACING and PAUSING, so this is the early warning: a
-- RED template is one about to stop sending, and by the time the PAUSED status
-- webhook lands the campaign is already dead. We were parsing the
-- `message_template_quality_update` webhook and only writing it to a log line.
--
-- Text, not an enum: Meta's quality vocabulary churns, and an unrecognized band
-- must be storable without a migration (same reasoning as the phone number's
-- `qualityRating`).
ALTER TABLE "MessageTemplate" ADD COLUMN "qualityScore" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "qualityScoreAt" TIMESTAMP(3);
