-- Broadcast.pausedReason: why the row was parked `paused`.
-- Lets the drift sweeper's auto-resume distinguish a transient cause (Meta
-- throttling, a graceful shutdown, credentials that were missing at fire time)
-- from one where retrying is pure waste (a template disabled at Meta, where each
-- retry burns another handful of recipients into `failed` and only an operator
-- action in Meta's console can fix it).
-- Nullable + no backfill: a NULL reason predates this column and is treated as
-- resumable, matching the behaviour those rows already had.
ALTER TABLE "Broadcast" ADD COLUMN "pausedReason" TEXT;
