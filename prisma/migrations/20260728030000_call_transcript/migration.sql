-- Call transcription (opt-in per call, independent of recording). Same
-- 7-day provider retention + download-to-R2 lifecycle as the recording
-- columns; the artifact is a JSON document. transcriptLanguage is the
-- AUTO-DETECTED spoken language (ISO 639, e.g. "ar"), denormalized from the
-- transcript body for list display/filtering.
ALTER TABLE "Call" ADD COLUMN "transcriptMediaId" TEXT;
ALTER TABLE "Call" ADD COLUMN "transcriptKey" TEXT;
ALTER TABLE "Call" ADD COLUMN "transcriptLanguage" TEXT;
