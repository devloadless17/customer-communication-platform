-- Reconstructed migration (file was lost; changes already live in DB). Idempotent.
-- Adds requestHash to ApiIdempotencyKey so a replayed key with a DIFFERENT body
-- is detected as a mismatch instead of silently returning the prior result.
ALTER TABLE "ApiIdempotencyKey" ADD COLUMN IF NOT EXISTS "requestHash" TEXT;
