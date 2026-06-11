-- Persist Meta's async delivery-failure diagnostics on the Message row. Before
-- this, a `status: "failed"` webhook with errors[] (131047 outside-window on an
-- API-accepted send, 131049 marketing frequency caps, 131026 undeliverable,
-- quality blocks) was only console.errored — agents saw a red icon with no
-- reason and diagnosis needed an SSH + journald grep per message. These nullable
-- columns carry errors[0].code / title / error_data.details so the failed bubble
-- (and per-recipient broadcast reporting) can show WHY. Null on every non-failed
-- status. ADD COLUMN with no default + no backfill = instant metadata-only DDL.
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "statusErrorCode" INTEGER;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "statusErrorTitle" TEXT;
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "statusErrorDetail" TEXT;
