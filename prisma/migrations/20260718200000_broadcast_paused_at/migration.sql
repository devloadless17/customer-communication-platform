-- Broadcast.pausedAt: when the row was last parked `paused`.
-- Lets the drift sweeper auto-resume a paused campaign after a cooldown instead
-- of only at process boot (a broadcast paused at 2am previously sat dead until
-- the next deploy). Nullable + no backfill: existing paused rows have a NULL
-- pausedAt, which the sweeper treats as immediately eligible.
ALTER TABLE "Broadcast" ADD COLUMN "pausedAt" TIMESTAMP(3);

-- Backs the sweeper's only scan: WHERE status = 'paused' AND pausedAt <= cutoff.
-- Plain (not partial) so it matches what @@index([status, pausedAt]) declares in
-- schema.prisma — a partial index here would read as drift on the next
-- `prisma migrate dev`. Plain CREATE INDEX (not CONCURRENTLY) matches repo
-- convention: Prisma wraps each migration in a transaction.
CREATE INDEX "Broadcast_status_pausedAt_idx" ON "Broadcast" ("status", "pausedAt");
