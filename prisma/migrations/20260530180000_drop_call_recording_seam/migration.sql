-- Drop the unused Phase-2 placeholder columns from Call. We don't have a
-- recording pipeline planned, and a future addition can come back via its
-- own migration when there's actually code that writes to them.
--
-- SUPERSEDES the "reuses the recordingKey/recordingUrl/transcriptId nullable
-- slots already in the Call model — no further migration needed" claim in the
-- 20260530120000_whatsapp_calling migration header. The recording roadmap, if
-- revived, belongs in docs/ — not in a dropped-column comment. Non-destructive:
-- these columns were null-only in Phase 1 and never read/written by any code.
ALTER TABLE "Call" DROP COLUMN IF EXISTS "recordingKey";
ALTER TABLE "Call" DROP COLUMN IF EXISTS "recordingUrl";
ALTER TABLE "Call" DROP COLUMN IF EXISTS "transcriptId";
