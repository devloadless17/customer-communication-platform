-- Track which agent PLACED an outbound call (so the thread can show "who
-- called", the way messages show their sender). Nullable: inbound calls have
-- no agent initiator, and the rare webhook-races-the-create path has no user
-- context (backfilled on the place-call retry). FK is SET NULL on user delete
-- so call history survives deactivation (mirrors answeredByUserId). Names match
-- Prisma's generated identifiers so schema + DB stay drift-free.
ALTER TABLE "Call" ADD COLUMN "initiatedByUserId" TEXT;

CREATE INDEX IF NOT EXISTS "Call_initiatedByUserId_idx" ON "Call"("initiatedByUserId");

ALTER TABLE "Call" ADD CONSTRAINT "Call_initiatedByUserId_fkey"
  FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
