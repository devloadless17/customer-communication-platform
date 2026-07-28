-- Call recording (opt-in per call via the workspace's recording policy).
-- `recordingMediaId` is the provider's media asset id from the
-- call_recording_available webhook (file expires provider-side after 7 days);
-- `recordingKey` is the R2 object once the bytes are persisted locally.
-- mediaId set + key null = download pending (retried by the recording sweeper).
ALTER TABLE "Call" ADD COLUMN "recordingMediaId" TEXT;
ALTER TABLE "Call" ADD COLUMN "recordingKey" TEXT;
ALTER TABLE "Call" ADD COLUMN "recordingMimeType" TEXT;
