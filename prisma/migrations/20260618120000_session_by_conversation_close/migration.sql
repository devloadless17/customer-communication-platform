-- Drop the time-gap session setting; sessions are now bounded by
-- conversation close (see session_kind: first_ever / returning_session /
-- continued, computed from isNewConversation + reopened in ingest).
ALTER TABLE "Team" DROP COLUMN "sessionGapMinutes";
